# Contributing

Thanks for your interest in SpriteForge.

This is an early-stage open-source project. The implementation is driven by the [Functional Specification](./docs/FSD.md) and prioritised by the maintainer, but thoughtful improvements, bug reports, and documentation are always appreciated.

## How to contribute

1. **Check existing issues** — avoid duplicate proposals.
2. **Open an issue** for bugs or feature requests before writing large changes.
3. **Reference the FSD** — keep new features aligned with the scope in [docs/FSD.md](./docs/FSD.md) or propose an update to the FSD.
4. **Run the checks** — `npm run check` (typecheck + DOM id scan) and `npm run build` should both pass before opening a PR.
5. **New exports** should demonstrate loading in a real Spine runtime (Phaser, PixiJS, Unity, Godot).

## Code style

- TypeScript strict mode.
- Variables and functions prefer descriptive names over short abbreviations.
- Comments explain intent, not what the code already shows.
- Bus events are defined in `bus.ts` or `keymap.ts`; new editor features use `bus.emit`/`bus.on`.

## Project scope

- **In scope:** Spine-compatible 2D skeletal animation editing, export, and a standalone web player.
- **Out of scope:** cloud services, mobile editor, server-side processing, 3D, audio mixing, physics.