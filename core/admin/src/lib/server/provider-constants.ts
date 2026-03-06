/**
 * Server-side provider constants derived from shared sources.
 *
 * Combines LLM_PROVIDERS and EMBED_PROVIDERS into a single
 * VALID_MODEL_PROVIDERS set for input validation in API routes.
 */
import { LLM_PROVIDERS, EMBED_PROVIDERS } from "./control-plane.js";

/** Union of all provider names accepted by model-listing endpoints. */
export const VALID_MODEL_PROVIDERS = new Set<string>([...LLM_PROVIDERS, ...EMBED_PROVIDERS]);
