import { auditDirectActiveKnowledge } from "../modules/security-intelligence/direct-active-audit.service.js";

process.stdout.write(`${JSON.stringify(await auditDirectActiveKnowledge(), null, 2)}\n`);
