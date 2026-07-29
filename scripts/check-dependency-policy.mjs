let input = "";

for await (const chunk of process.stdin) {
  input += chunk;
}

const config = JSON.parse(input);
const violations = [];

if (config.minimumReleaseAge !== 10_080) {
  violations.push("minimumReleaseAge must be exactly 10080 minutes (seven days)");
}

if (config.minimumReleaseAgeStrict !== true) {
  violations.push("minimumReleaseAgeStrict must remain enabled");
}

if (config.trustLockfile !== false) {
  violations.push("trustLockfile must remain disabled");
}

const exclusions = config.minimumReleaseAgeExclude;
if (exclusions != null && (!Array.isArray(exclusions) || exclusions.length > 0)) {
  violations.push("minimumReleaseAgeExclude must be absent or empty");
}

if (violations.length > 0) {
  throw new Error(`Dependency quarantine policy failed:\n- ${violations.join("\n- ")}`);
}

console.log("Dependency quarantine policy: seven days, strict, no exceptions");
