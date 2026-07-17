import { collectDoctorReport, formatDoctorReport } from "./doctor";
import { loadLocalEnvironment } from "./local-env";

loadLocalEnvironment();
const report = await collectDoctorReport();
process.stdout.write(`${formatDoctorReport(report)}\n`);
if (report.overall === "ACTION_REQUIRED" || report.overall === "ERROR") process.exitCode = 1;
