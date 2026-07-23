/**
 * Host-zod re-export + the shared string output schema.
 *
 * Every tool's `outputSchema` is `z.string()` — a tool returns clean
 * text to the model, so ciphertext can never ride a struct field and benign
 * "no reply" strings never trip v1 output-validation.
 * This is authored with the HOST `zod` (the single hoisted instance Mastra
 * validates against), NOT the SDK's re-exported `z`. Centralizing the one shared
 * instance here keeps `import { z } from "zod"` out of every tool module while
 * staying drift-proof.
 */

import { z } from "zod";

export { z };

/** The shared `outputSchema` for every rine tool: a plain string. */
export const strResult = z.string();
