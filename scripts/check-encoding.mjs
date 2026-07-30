import fs from "node:fs";
import path from "node:path";
const roots=["frontend/src","backend/src","backend/supabase","README.md"];
const bad=/Ã|Â|â(?:€¦|†’|€”)|ðŸ|ï¿½/u;const extensions=new Set([".ts",".tsx",".css",".md",".sql"]);const files=[];
function visit(target){const stat=fs.statSync(target);if(stat.isDirectory()){for(const name of fs.readdirSync(target))visit(path.join(target,name));}else if(extensions.has(path.extname(target))||target.endsWith("README.md"))files.push(target)}
for(const root of roots)visit(root);const failures=files.filter(file=>bad.test(fs.readFileSync(file,"utf8")));if(failures.length){console.error(`Invalid UTF-8/mojibake sequences found:\n${failures.join("\n")}`);process.exit(1)}console.log(`Encoding check passed (${files.length} files).`);
