// SCRATCH (not committed): stands in for the Mac export of app.language until the real
// settings-schema.json regeneration lands, so the fleet run can exercise the Language row.
import fs from "node:fs";

const exportPath = "../schemas/settings/settings-schema.json";
const schema = JSON.parse(fs.readFileSync(exportPath, "utf8"));
if (!schema.rows.some((row) => row.key === "app.language")) {
  const source = JSON.parse(fs.readFileSync("../schemas/settings/source/general.json", "utf8"));
  const list = source.lists.find((entry) => entry.name === "language");
  const row = list.rows[0];
  const base = structuredClone(schema.rows.find((entry) => entry.key === "navigation.historyScope"));
  Object.assign(base, {
    key: row.key,
    path: row.key.split("."),
    group: list.group,
    title: row.title,
    help: row.help ?? null,
    summary: row.summary ?? null,
    choices: row.choices.map((choice) => ({ title: choice.title, value: choice.value })),
    default: row.default ?? "system",
    keywords: row.keywords ?? ["language"],
    accepts: row.choices.map((choice) => choice.value),
  });
  schema.rows.unshift(base);
  const general = schema.page.categories.find((category) => category.id === "general" || category.aliases?.includes("general"));
  general.groups.unshift({ key: list.group.key, rows: [row.key], title: list.group });
  fs.writeFileSync(exportPath, JSON.stringify(schema, null, 2) + "\n");
  console.log("scratch: app.language added to the export");
}
