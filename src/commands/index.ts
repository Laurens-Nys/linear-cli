// Side-effect imports: each module registers its commands on import.
// main.ts imports this one file, so adding a command never touches main.ts.
//
// Ownership is per file. Add your commands to your own file; do not edit
// another agent's. See INTERFACES.md.

// meta (core agent)
import "./api.ts";
import "./auth.ts";
import "./cache-cmd.ts";
import "./schema.ts";

// issue agent
import "./issue.ts";
import "./issue-extra.ts";
import "./comment.ts";

// project agent
import "./project.ts";
import "./milestone.ts";
import "./cycle.ts";
import "./initiative.ts";
import "./doc.ts";

// workspace agent
import "./team.ts";
import "./user.ts";
import "./label.ts";
import "./template.ts";
import "./customer.ts";
import "./inbox.ts";

// alias agent
import "./aliases.ts";
import "./skill.ts";
import "./completions.ts";
