from __future__ import annotations

# Configurable estimated pricing per 1 Million tokens (USD)
# Free-tier default is 0.0, but cost tracking mechanism is preserved and configurable.
MODEL_PRICING: dict[str, dict[str, float]] = {
    "default": {"prompt": 0.0, "completion": 0.0},
    "nvidia/nemotron-4-340b-instruct": {"prompt": 0.50, "completion": 1.50},
    "meta/llama-3.1-70b-instruct": {"prompt": 0.35, "completion": 0.40},
    "meta/llama-3.1-8b-instruct": {"prompt": 0.10, "completion": 0.10},
    "meta/llama-3.3-70b-instruct": {"prompt": 0.35, "completion": 0.40},
}


def estimate_cost(
    model: str,
    tokens_in: int,
    tokens_out: int,
) -> float:
    """Calculate estimated cost in USD based on model pricing per million tokens."""
    pricing = MODEL_PRICING.get(model, MODEL_PRICING["default"])
    cost_in = (tokens_in / 1_000_000.0) * pricing["prompt"]
    cost_out = (tokens_out / 1_000_000.0) * pricing["completion"]
    return round(cost_in + cost_out, 6)

