// Intelligence — the agent catalog the launcher's control plane owns.
//
// One opinionated default (the Auracle Agent, wrapping DeepSeek over the
// user's own loopback engine) plus frontier bring-your-own-key
// alternatives (Anthropic / OpenAI / Google). This module is the single
// place that knows two things at once:
//
//   1. The ENGINE-FACING provider id + model id we persist via
//      settingsPut → /ui/api/settings. The engine validates the
//      provider against its `_AI_PROVIDERS` whitelist and resolves the
//      vaulted key under that exact provider name, so `configured` from
//      the aggregate is honest. These ids MUST be engine-valid.
//
//   2. The IDE-FACING selection identity the native IDE's Auracle-Agent
//      provider consumes (provider `auracle-agent`, model `deepseek-chat`
//      — the ids the shipped IDE language-model provider declares; see
//      crates/language_models/src/provider/auracle.rs and
//      assets/settings/initial_user_settings.json in the IDE repo).
//
// JUDGMENT CALL (documented): PRD #168's headline says "write
// {ai_model:{provider:'auracle-agent', model:'deepseek-chat'}}". Taken
// literally that 400s at the engine — `auracle-agent` is not in the
// engine's `_AI_PROVIDERS` whitelist, and `configured` would never flip
// true because no vault key lives under that name. The PRD body resolves
// the tension itself: "The Auracle Agent is represented as the DeepSeek
// provider selection ... choosing it is what tells the IDE to call the
// loopback gateway." So we persist the engine-valid `deepseek_api_key` /
// `deepseek-chat`, and carry the `auracle-agent` / `deepseek-chat`
// identity as the IDE-facing pair that the IDE already maps DeepSeek to.
// Honesty over a literal string: `configured` stays truthful and the
// engine never 400s. The invented `deepseek-v4-*` ids the IDE bug once
// used are deliberately NOT referenced anywhere here.

/** A selectable agent in the Intelligence card. */
export interface AgentOption {
  /** Stable id for the selector + persistence round-trip. */
  id: string;
  /** Human label shown in the card. */
  label: string;
  /** One-line description of what this agent is. */
  blurb: string;
  /** True for the self-hosted Auracle Agent (the default option). */
  isDefault: boolean;
  /** The engine-valid AI provider id we PUT under `ai_model.provider`.
   *  Must be a member of the engine's `_AI_PROVIDERS` whitelist so the
   *  vaulted key resolves and `configured` is honest. */
  engineProvider: string;
  /** The model id we PUT under `ai_model.model_id`. Opaque to the engine
   *  (a free-form string), consumed by the agent provider. */
  engineModel: string;
  /** Placeholder shown in this agent's API-key field. */
  keyPlaceholder: string;
  /** Short note about the one prerequisite, when there is one. */
  prerequisite?: string;
}

/** The native IDE's Auracle-Agent provider identity. The launcher only
 *  configures the engine selection + key; the IDE seeds its agent from
 *  this pair when the engine reports the DeepSeek selection. Pinned to
 *  the exact ids the shipped IDE provider declares — NOT invented ones. */
export const IDE_AGENT_PROVIDER = "auracle-agent";
export const IDE_AGENT_MODEL = "deepseek-chat";

/** The Auracle Agent option id (the card's default). */
export const AURACLE_AGENT_ID = "auracle-agent";

/** The agent catalog, in display order. The Auracle Agent leads as the
 *  default; the frontier providers follow as BYO-key alternatives. */
export const AGENTS: AgentOption[] = [
  {
    id: AURACLE_AGENT_ID,
    label: "Auracle Agent (DeepSeek)",
    blurb:
      "The self-hosted default. Your engine wraps DeepSeek over loopback " +
      "with your own key — your prompts and key stay on your machine, and " +
      "you pay the token costs directly.",
    isDefault: true,
    // Persisted as the engine's whitelisted DeepSeek provider so the key
    // vaults correctly and `configured` reflects engine truth. The IDE
    // maps this selection to its own `auracle-agent` / `deepseek-chat`.
    engineProvider: "deepseek_api_key",
    engineModel: IDE_AGENT_MODEL,
    keyPlaceholder: "Paste your DeepSeek API key",
    prerequisite: "Requires a DeepSeek key, entered here.",
  },
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    blurb: "Bring your own Anthropic key to use a Claude model.",
    isDefault: false,
    engineProvider: "anthropic",
    engineModel: "",
    keyPlaceholder: "Paste your Anthropic API key",
  },
  {
    id: "openai",
    label: "GPT (OpenAI)",
    blurb: "Bring your own OpenAI key to use a GPT model.",
    isDefault: false,
    engineProvider: "openai_api_key",
    engineModel: "",
    keyPlaceholder: "Paste your OpenAI API key",
  },
  // NOTE: Gemini (Google) is named in PRD #168 as a third frontier
  // alternative, but the engine's `_AI_PROVIDERS` whitelist
  // (anthropic / openai_api_key / deepseek_api_key / ollama_host) has no
  // Google slot yet — a PUT with provider="google" would 400 at the
  // engine. Per the honesty contract (no control that fakes success / a
  // clear error state) we ship only the engine-valid frontier providers
  // and add Gemini here the moment the engine whitelists it. The card is
  // catalog-driven, so that's a one-line addition with no rewrite.
];

/** Find an agent option by its selector id. */
export function agentById(id: string): AgentOption | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** Map an engine-reported `ai_model.provider` back to a catalog agent id,
 *  so the card can seed its selector from the aggregate. Falls back to the
 *  default agent when the stored provider is empty or unrecognized. */
export function agentIdFromEngineProvider(provider: string | undefined): string {
  if (!provider) return AURACLE_AGENT_ID;
  const match = AGENTS.find((a) => a.engineProvider === provider);
  return match ? match.id : AURACLE_AGENT_ID;
}

/** Build the `ai_model` patch body for a chosen agent + optional model
 *  override + optional new key. The provider + model are the
 *  engine-facing ids; a non-empty key rides to the vault. An empty key
 *  is omitted so a selection change never wipes a stored key.
 *
 *  Exported (and unit-tested) because this is the exact shape that
 *  crosses the launcher↔engine seam — the contract worth pinning. */
export function buildAiModelPatch(
  agentId: string,
  modelOverride: string,
  key: string,
): { provider: string; model_id: string; key?: string } {
  const agent = agentById(agentId) ?? AGENTS[0];
  const model = modelOverride.trim() || agent.engineModel;
  const trimmedKey = key.trim();
  return {
    provider: agent.engineProvider,
    model_id: model,
    ...(trimmedKey ? { key: trimmedKey } : {}),
  };
}
