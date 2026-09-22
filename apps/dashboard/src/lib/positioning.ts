// The one positioning line for PCC, and the name it expands to.
//
// Why this exists: five different one-line definitions of PCC once shipped at the same
// time (landing hero, /docs, the dashboard <title>/OG tags, /start and the agent-package
// description, about.html). Every published surface now states this line verbatim;
// src/lib/__tests__/positioning-line.test.ts fails CI if one drifts or a retired tagline
// comes back. To change the line, change it here and fix every file that test lists.

export const PCC_NAME = "Physical Capability Cloud";
export const PCC_POSITIONING_LINE = "AWS for the physical world";
