import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** The marker follows the installed package, including packed artifacts. */
export const SPEKO_USER_AGENT = `openclaw-speko/${version}`;
