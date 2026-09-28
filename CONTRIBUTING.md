# Contributing

Thanks for taking an interest in Uni radio.

## Development Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The default LLM is Seed 2.1 Pro. Copy `.env.example` and set `SEED_API_KEY` before testing flows that call the model.

Run tests before opening a pull request:

```bash
node --test tests/*.test.js
```

## Pull Request Guidelines

- Keep changes focused and explain the user-facing behavior.
- Do not commit `.env`, `data/`, `cache/`, cookies, generated TTS files, or personal playlist dumps.
- Add tests when changing shared logic such as queue policy, LLM routing, setup import, or WebSocket buffering.
- Preserve the local-first privacy model unless the PR explicitly discusses a hosted deployment mode.

## Code Style

- This project uses native ES modules.
- Prefer small functions and plain Node.js APIs.
- Keep browser code framework-free unless there is a strong reason to add a dependency.
- Avoid broad refactors in feature PRs.

## Security and Privacy

NetEase cookies and listener data are sensitive. Treat bugs that expose local user data as security issues and follow [SECURITY.md](SECURITY.md).
