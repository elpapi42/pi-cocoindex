import { Type } from "@mariozechner/pi-ai";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";

export const SearchParams = Type.Object({
	query: Type.String({ description: "Natural-language description of the code, behavior, concept, or responsibility to find." }),
	limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_LIMIT, description: `Maximum number of matches to return. Defaults to ${DEFAULT_LIMIT}.` })),
	path: Type.Optional(Type.String({ description: "Optional project-relative file or glob to narrow semantic search. Omit unless the user named a specific area or broad results were too noisy. Files like `src/index.ts` work directly; for recursive directory search, use a glob like `src/**` rather than plain `src` or `src/`." })),
});
