# Synthetic Mode Boundary (API-First SSoT Refactor)

## Policy In This Phase

- API/real mode is authoritative for canonical fire emission and diagnostics.
- Synthetic mode remains a legacy JS evaluator path for simulation and UI fallback.
- Synthetic outputs are not part of API/backtest parity guarantees.

## Why This Boundary Exists

- It preserves existing synthetic workflows while removing dual-maintenance burden for API-mode strategy additions.
- It allows backend diagnostics contracts to evolve independently from legacy simulation internals.

## Guardrails

- API mode must not append frontend-generated canonical fires.
- Frontend evaluator fallback in API mode is display-only and used only when backend diagnostics are missing.
- Unknown backend diagnostic versions log warnings and degrade safely in UI.

## Future Options (Out of Scope Here)

- Keep synthetic mode permanently as a lightweight sandbox.
- Rebuild synthetic mode on backend-evaluated streams.
- Remove synthetic evaluators after replacement tooling is in place.
