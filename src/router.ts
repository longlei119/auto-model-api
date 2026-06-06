import { conversationSignature } from "./context.js";
import type { AppConfig, InternalRequest, ProviderConfig, RouteDecision } from "./types.js";
import { MetricsStore } from "./metrics.js";

export class ProviderRouter {
  private readonly sessions = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly metrics: MetricsStore
  ) {}

  choose(req: InternalRequest): RouteDecision {
    const candidates = this.candidatesFor(req.model);
    if (candidates.length === 0) {
      throw new Error(`No enabled providers can serve model alias ${req.model}`);
    }

    const mode = this.config.routing.mode;
    if (mode === "manual" || mode === "fallback") {
      return this.withFallbackCandidates(this.defaultCandidate(candidates), candidates);
    }

    if (mode === "session") {
      const signature = conversationSignature(req);
      const existingProviderId = this.sessions.get(signature);
      const existing = candidates.find((candidate) => candidate.provider.id === existingProviderId);
      if (existing) {
        return this.withFallbackCandidates(existing, candidates);
      }

      const selected = this.fastestCandidate(candidates);
      this.sessions.set(signature, selected.provider.id);
      return this.withFallbackCandidates(selected, candidates);
    }

    return this.withFallbackCandidates(this.fastestCandidate(candidates), candidates);
  }

  preview(requestedModel: string): RouteDecision {
    const candidates = this.candidatesFor(requestedModel);
    if (candidates.length === 0) {
      throw new Error(`No enabled providers can serve model alias ${requestedModel}`);
    }

    const selected = this.config.routing.mode === "manual" || this.config.routing.mode === "fallback"
      ? this.defaultCandidate(candidates)
      : this.fastestCandidate(candidates);
    return this.withFallbackCandidates(selected, candidates);
  }

  private candidatesFor(requestedModel: string): Array<{ provider: ProviderConfig; model: string }> {
    const aliases = this.config.modelAliases[requestedModel] ?? [requestedModel];
    const enabled = this.config.providers.filter((provider) => provider.enabled);
    const candidates: Array<{ provider: ProviderConfig; model: string }> = [];

    for (const alias of aliases) {
      for (const provider of enabled) {
        if (provider.models.includes(alias)) {
          candidates.push({ provider, model: alias });
        }
      }
    }

    if (candidates.length === 0) {
      for (const provider of enabled) {
        const fallbackModel = provider.models[0];
        if (fallbackModel) {
          candidates.push({ provider, model: fallbackModel });
        }
      }
    }

    return candidates.sort((a, b) => a.provider.priority - b.provider.priority);
  }

  private defaultCandidate(candidates: Array<{ provider: ProviderConfig; model: string }>): { provider: ProviderConfig; model: string } {
    return candidates.find((candidate) => candidate.provider.id === this.config.defaultProvider) ?? candidates[0];
  }

  private fastestCandidate(candidates: Array<{ provider: ProviderConfig; model: string }>): { provider: ProviderConfig; model: string } {
    return [...candidates].sort((a, b) => {
      const scoreDelta = this.metrics.score(a.provider.id, a.model) - this.metrics.score(b.provider.id, b.model);
      if (scoreDelta !== 0) return scoreDelta;
      return a.provider.priority - b.provider.priority;
    })[0];
  }

  private withFallbackCandidates(
    selected: { provider: ProviderConfig; model: string },
    candidates: Array<{ provider: ProviderConfig; model: string }>
  ): RouteDecision {
    const rest = candidates
      .filter((candidate) => candidate.provider.id !== selected.provider.id)
      .sort((a, b) => {
        const scoreDelta = this.metrics.score(a.provider.id, a.model) - this.metrics.score(b.provider.id, b.model);
        if (scoreDelta !== 0) return scoreDelta;
        return a.provider.priority - b.provider.priority;
      });
    return {
      provider: selected.provider,
      model: selected.model,
      candidates: [selected, ...rest]
    };
  }
}
