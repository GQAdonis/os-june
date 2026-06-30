import type { VeniceModelDto } from "./tauri";

// June's default image model. Mirrors DEFAULT_IMAGE_MODEL in the Rust providers
// module (src-tauri/src/providers/mod.rs) — keep the two in sync.
export const DEFAULT_IMAGE_MODEL = "venice-sd35";

// Curated Venice image models for the settings picker. Image models are not
// part of the priced model catalog the backend serves (that catalog drives
// billing, which is deferred for image generation), so the picker uses this
// local snapshot instead of fetching. The persisted choice is just a model id
// string, so a user can still target a model not listed here; this list only
// shapes the default and the picker options.
export const IMAGE_MODELS: VeniceModelDto[] = [
  {
    provider: "venice",
    id: "venice-sd35",
    name: "Venice SD3.5",
    modelType: "image",
    description: "Venice's default Stable Diffusion 3.5 image model.",
    traits: ["default"],
    capabilities: [],
  },
  {
    provider: "venice",
    id: "flux-dev",
    name: "FLUX.1 Dev",
    modelType: "image",
    description: "High-detail image model for photorealistic results.",
    traits: [],
    capabilities: [],
  },
  {
    provider: "venice",
    id: "qwen-image",
    name: "Qwen Image",
    modelType: "image",
    description: "Strong text rendering and prompt adherence.",
    traits: [],
    capabilities: [],
  },
  {
    provider: "venice",
    id: "hidream",
    name: "HiDream",
    modelType: "image",
    description: "Versatile general-purpose image model.",
    traits: [],
    capabilities: [],
  },
];
