#!/usr/bin/env python3
"""A same-tree tier's job posts its own `(same-tree)` status the moment it ends.

SAME_TREE_STATUS_FROM_JOB (2026-11-14, hq#11150). Run 43660624788's daemon tests passed and their status post got
HTTP 403 on the workflow token (the repository's shared hourly budget), so `cmux-next daemon tests (same-tree)`
never posted. A `--failed` re-run of that job cannot start while a scheme compile in the same run sits queued, so a
green pull request (#43350) stayed held. The fix: each tier's job posts its own status from inside the job, with a
cmux-bot App token (its own budget) as the spare, and the scheme tier's post lives in the compile job (it sat in
crash-ends-app, whose `permissions: {}` token could never post one, and which the DEV daily skips).
"""

from __future__ import annotations

import http.server
import json
import os
import subprocess
import threading
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CMUX_NEXT = ROOT / ".github" / "workflows" / "cmux-next.yml"
POST = ROOT / "scripts" / "ci" / "post_same_tree_status.sh"
REPORT = "Report the same-tree result on the tested commit"
MINT = "Mint the cmux-bot same-tree status token"
SHA = "619bd5099c378e9ec7f29d0a1a5604e032320749"


def _steps(job: dict) -> list[dict]:
    return job.get("steps") or []


class WorkflowShape(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.jobs = yaml.safe_load(CMUX_NEXT.read_text())["jobs"]

    def _report_jobs(self) -> dict[str, dict]:
        return {name: job for name, job in self.jobs.items() if any(s.get("name") == REPORT for s in _steps(job))}

    def test_each_tier_posts_from_the_job_that_tested_it(self):
        reporters = self._report_jobs()
        self.assertEqual(set(reporters), {"daemon-test", "cmux-scheme-compile"})
        contexts = {name: next(s for s in _steps(job) if s.get("name") == REPORT)["env"]["CONTEXT"]
                    for name, job in reporters.items()}
        self.assertEqual(contexts["daemon-test"], "cmux-next daemon tests (same-tree)")
        self.assertIn("cmux app scheme compile (Debug) (same-tree)", contexts["cmux-scheme-compile"])
        self.assertIn("cmux NEXT DEV Release compile (same-tree)", contexts["cmux-scheme-compile"])

    def test_no_job_posts_a_status_without_the_grant(self):
        for name, job in self.jobs.items():
            posts = any("statuses/" in (s.get("run") or "") or s.get("name") == REPORT for s in _steps(job))
            if not posts:
                continue
            perms = job.get("permissions")
            mints = any((s.get("with") or {}).get("permission-statuses") == "write" for s in _steps(job))
            self.assertTrue(isinstance(perms, dict) and perms.get("statuses") == "write" or mints,
                            f"{name} posts a commit status but its token cannot")

    def test_the_post_runs_last_on_every_outcome_with_a_spare_token(self):
        for name, job in self._report_jobs().items():
            steps = _steps(job)
            names = [s.get("name") for s in steps]
            report = steps[names.index(REPORT)]
            mint = steps[names.index(MINT)]
            self.assertEqual(names[-1], REPORT, f"{name}: the post is the job's last step")
            self.assertLess(names.index(MINT), names.index(REPORT))
            # always(): a failed or cancelled job still posts (cancelled is error, which merge_hold re-runs)
            for step in (mint, report):
                self.assertTrue(step["if"].replace("${{", "").strip().startswith("always()"), f"{name}: {step['name']}")
            self.assertEqual(mint.get("continue-on-error"), True)
            self.assertEqual(mint["with"]["permission-statuses"], "write")
            self.assertEqual(report["env"]["GH_TOKEN_SPARE"], "${{ steps.%s.outputs.token }}" % mint["id"])
            self.assertEqual(report["env"]["JOB_STATUS"], "${{ job.status }}")
            self.assertNotIn("continue-on-error", report)
            run = report["run"]
            self.assertIn("cancelled) state=error", run)
            self.assertIn("scripts/ci/post_same_tree_status.sh", run)
            self.assertIn("checkout failed", run)  # no checkout: one bare post, then red
            self.assertNotIn("|| echo", run)
            perms = job["permissions"]
            self.assertEqual(perms.get("statuses"), "write")

    def test_the_scheme_tier_keeps_the_crash_gate_red(self):
        job = self.jobs["cmux-scheme-compile"]
        report = next(s for s in _steps(job) if s.get("name") == REPORT)
        self.assertEqual(report["env"]["CRASH_GATE"], "${{ steps.crash-gate.outcome }}")
        self.assertIn('"$CRASH_GATE" == failure', report["run"])
        self.assertFalse(any(s.get("name") == REPORT for s in _steps(self.jobs["crash-ends-app"])))


class _Fake(http.server.BaseHTTPRequestHandler):
    # token -> list of (code, headers, body) answers, popped in order; the last one repeats
    plan: dict[str, list] = {}
    seen: list[tuple[str, dict]] = []

    def do_POST(self):
        token = self.headers.get("Authorization", "").removeprefix("Bearer ")
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        _Fake.seen.append((token, body, self.path))
        answers = _Fake.plan.get(token) or [(401, {}, '{"message":"Bad credentials"}')]
        code, headers, text = answers.pop(0) if len(answers) > 1 else answers[0]
        self.send_response(code)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(text.encode())

    def log_message(self, *_args):
        pass


LIMITED = (403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1"},
           '{"message":"API rate limit exceeded for installation."}')
CREATED = (201, {}, '{"state":"success"}')


class PostScript(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Fake)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        _Fake.seen = []

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def _post(self, plan: dict, state="success", **env) -> subprocess.CompletedProcess:
        _Fake.plan = {k: list(v) for k, v in plan.items()}
        full = {"PATH": os.environ["PATH"], "GITHUB_API_URL": f"http://127.0.0.1:{self.server.server_port}",
                "GITHUB_REPOSITORY": "manaflow-ai/cmux", "GH_TOKEN": "workflow", "LIMIT_GAP": "1",
                "POST_GAP": "1", "POST_BUDGET": "3", **env}
        return subprocess.run(["bash", str(POST), SHA, "cmux-next daemon tests (same-tree)", state,
                               "same-tree cmux-tui run: success", "https://example.invalid/run"],
                              env=full, capture_output=True, text=True, timeout=60)

    def test_a_rate_limited_workflow_token_hands_over_to_the_spare_at_once(self):
        result = self._post({"workflow": [LIMITED], "spare": [CREATED]}, GH_TOKEN_SPARE="spare")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([t for t, _, _ in _Fake.seen], ["workflow", "spare"])
        token, body, path = _Fake.seen[-1]
        self.assertEqual(path, f"/repos/manaflow-ai/cmux/statuses/{SHA}")
        self.assertEqual(body["context"], "cmux-next daemon tests (same-tree)")
        self.assertEqual(body["state"], "success")

    def test_a_cancelled_job_posts_error(self):
        result = self._post({"workflow": [CREATED]}, state="error")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(_Fake.seen[0][1]["state"], "error")

    def test_a_rate_limit_on_every_token_waits_then_posts(self):
        result = self._post({"workflow": [LIMITED, CREATED]}, POST_BUDGET="30")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(len(_Fake.seen), 2)
        self.assertIn("posting again", result.stdout)

    def test_a_status_never_posted_is_red(self):
        result = self._post({"workflow": [LIMITED], "spare": [LIMITED]}, GH_TOKEN_SPARE="spare")
        self.assertEqual(result.returncode, 1)
        self.assertIn("::error title=same-tree status not posted::", result.stdout)
        self.assertIn("re-run this job", result.stdout)

    def test_a_bad_grant_is_final_without_waiting(self):
        result = self._post({"workflow": [(403, {}, '{"message":"Resource not accessible by integration"}')]},
                            POST_BUDGET="600")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(_Fake.seen), 1)

    def test_not_a_commit_is_a_warning(self):
        _Fake.plan = {}
        result = subprocess.run(["bash", str(POST), "not-a-sha", "c", "success", "d", "u"],
                                env={"PATH": os.environ["PATH"], "GITHUB_REPOSITORY": "o/r", "GH_TOKEN": "x"},
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0)
        self.assertIn("::warning::not a commit", result.stdout)
        self.assertEqual(_Fake.seen, [])


if __name__ == "__main__":
    unittest.main()
