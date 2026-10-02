# Maintainer map

- Read `IMPLEMENTATION.md` before continuing the active daily-use parity work; update its milestone status, verification evidence, and next action as work progresses.
- Use `PORT-MATRIX.md` to locate reference behavior. Treat `.references/claude-analysis/report/` as analysis and verify disputed behavior in `pretty/` or `modules/`.
- Keep project identity and configuration in `src/config.ts`, memory/index mutations and path containment in `src/store.ts`, recall selection/state in `src/recall.ts`, and model operation parsing/prompts in `src/extract.ts`.
- Route structured saves, extraction operations, and promotion through `mutateMemory`; do not write a second index-update path.
- Preserve legacy basename directories. Import only through the explicit conflict-safe command; never infer which project owns a legacy directory.
- Keep code comments focused on ownership, lifecycle, compatibility, and failure semantics. Record progress in `IMPLEMENTATION.md`, not comments.
- Run `npm run check`, `npm test`, and `git diff --check` for each implementation milestone. Tests use temporary roots and mocked model calls; never point them at personal memory.
- Update README and the parity matrix when changing observable behavior. Distinguish copied text/constants from verified end-to-end behavior.
- Test observable state transitions, persistence, and data flow. Do not assert prompt prose, UI labels, error wording, fixed defaults, or serialization layout; vary payloads and verify their preservation where content delivery is the behavior.
- Reuse pi's public session/context, model registry, mutation queue, and lifecycle APIs before adding infrastructure. Keep plugin-specific policy here; document a missing host capability before introducing a replacement.
