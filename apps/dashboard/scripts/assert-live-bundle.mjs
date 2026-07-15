import { readdir, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const distDirectory = new URL("../dist/", import.meta.url);
const forbiddenShowcaseValues = [
  "018ff3ef-f9dd-7c29-a648-d8dd59a9b001",
  "018ff3ef-f9dd-7c29-a648-d8dd59a9b002",
  "Property search filters reset on mobile",
  "Gold customers",
  "Maya Patel",
  "Sarah Chen",
  "sarah.chen@example.com",
  "manager@example.com",
  "RPR-10247",
];

const files = await collectFiles(distDirectory);
const searchableFiles = files.filter((file) => [".html", ".js", ".css", ".json", ".map"].includes(extname(file)));
const leaks = [];

for (const file of searchableFiles) {
  const contents = await readFile(file, "utf8");
  for (const value of forbiddenShowcaseValues) {
    if (contents.includes(value)) leaks.push(`${value} in ${file}`);
  }
}

const assetNames = files.map((file) => file.toLowerCase());
for (const marker of ["maya-patel", "sarah-chen", "template-preview-blank"]) {
  if (assetNames.some((file) => file.includes(marker))) leaks.push(`${marker} asset in live bundle`);
}

if (leaks.length > 0) {
  throw new Error(`Live dashboard bundle contains showcase data:\n${leaks.join("\n")}`);
}

console.log("Live dashboard bundle contains no showcase fixtures or assets.");

async function collectFiles(directoryUrl) {
  const entries = await readdir(directoryUrl, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory()) return collectFiles(new URL(`${entry.name}/`, directoryUrl));
    return [fileURLToPath(new URL(entry.name, directoryUrl))];
  }));
  return nested.flat();
}
