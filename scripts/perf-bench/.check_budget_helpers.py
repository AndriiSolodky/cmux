import sys
sys.path.insert(0, "scripts/perf-bench")
import budget

class App:
    def call(self, method, params=None, timeout=0):
        if method == "renderers.list":
            return {"renderers": [{"pid": 7, "kind": "agent-pane", "memory_bytes": 150 << 20,
                                   "pages": [{"url": "cmux-page://cmux.agent/", "kind": "agent-pane"}]},
                                  {"pid": 8, "kind": "extension", "memory_bytes": 95 << 20, "pages": []}]}
        if method == "debug.wakeups":
            return {"total_per_second": 3.5, "active_frame_clients": [],
                    "ledger": [{"owner": "X", "reason": "y", "per_second": 2.5}],
                    "main_run_loop": "<CFRunLoopTimer 0x1 [0x2]>{valid = Yes, firing = No, interval = 1, tolerance = 0, next fire date = 1, callout = (Delayed Perform) Foo }"}
        if method == "debug.cef":
            return {"spare_window": "none", "spare_page": "none", "likely": None}
        raise OSError("boom")

class Raising:
    def call(self, *a, **k):
        raise OSError("socket gone")

class B: pass
lines = []
b = B(); b.app = App()
budget._log_home_processes(b, [{"pid": 1, "kind": "main", "footprint_mb": 254.5}], lines.append)
budget._log_app_wakers(b, "home", lines.append)
r = B(); r.app = Raising()
budget._log_home_processes(r, [], lines.append)
budget._log_app_wakers(r, "tabs-hidden", lines.append)
print("\n".join(lines))
assert any("home renderer:" in l and "cmux-page://cmux.agent/" in l for l in lines)
assert any("main timer: every 1.000 s" in l for l in lines)
assert any("tabs-hidden wakers: not read (OSError" in l for l in lines)
print("CHECK OK")
