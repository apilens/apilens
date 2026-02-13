# APILens

> **This project is under active development. There is no first release yet.**
> Things will break, APIs will change, and features are incomplete.
> If you'd like to contribute, you're warmly welcome — see [Contributing](#contributing) below.

APILens is an observability platform for monitoring APIs. Track requests, analyze performance, and get alerts when things go wrong.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Python 3.13, Django 5, Django Ninja |
| Frontend | Next.js 16, React 19, TypeScript |
| Database | PostgreSQL |
| Auth | Magic link email + JWT (custom, no third-party provider) |

## Prerequisites

- **Python 3.11+** (we use 3.13)
- **Node.js 20+**
- **PostgreSQL 15+**
- **uv** (Python package manager) — [install guide](https://docs.astral.sh/uv/getting-started/installation/)

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/apilens/apilens.git
cd apilens
```

### 2. Set up PostgreSQL

You need a running PostgreSQL instance with a database and user for APILens.

<details>
<summary><strong>Ubuntu / Debian</strong></summary>

```bash
# Install PostgreSQL (skip if already installed)
sudo apt update && sudo apt install -y postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Create user and database
# (If these already exist, the commands will print a notice — that's fine.)
sudo -u postgres psql -c "CREATE USER apilens WITH PASSWORD 'apilens_password';" 2>/dev/null || echo "User may already exist"
sudo -u postgres psql -c "CREATE DATABASE apilens OWNER apilens;" 2>/dev/null || echo "Database may already exist"
```

</details>

<details>
<summary><strong>macOS (Homebrew)</strong></summary>

```bash
brew install postgresql@16
brew services start postgresql@16

psql postgres -c "CREATE USER apilens WITH PASSWORD 'apilens_password';"
psql postgres -c "CREATE DATABASE apilens OWNER apilens;"
```

</details>

<details>
<summary><strong>Using an existing PostgreSQL instance</strong></summary>

Just create a database and user, then update the credentials in `backend/.env` after step 3.

</details>

### 3. Backend setup

```bash
cd backend

# Create virtual environment
uv venv
source .venv/bin/activate   # On Windows: .venv\Scripts\activate

# Install all dependencies
uv pip install -e .

# Create environment file from template
cp .env.example .env
```

The defaults in `.env` match the PostgreSQL setup above (`apilens` / `apilens_password`). If you used different credentials, edit `backend/.env` now.

Run migrations and start the server:

```bash
python manage.py migrate
python manage.py runserver
```

✅ Backend API → **http://localhost:8000/api/v1/**
✅ Swagger docs → **http://localhost:8000/api/v1/docs**

### 4. Frontend setup

Open a **new terminal**:

```bash
cd frontend

# Install dependencies
npm install

# Create environment file and generate session secret
cp .env.example .env.local
```

Generate a session encryption secret and add it to `.env.local`:

```bash
# Generate and write the secret in one command
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
sed -i "s/^SESSION_SECRET=.*$/SESSION_SECRET=$SECRET/" .env.local
```

Or manually: run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, copy the output, and paste it after `SESSION_SECRET=` in `.env.local`.

Start the dev server:

```bash
npm run dev
```

✅ Frontend → **http://localhost:3000**

### 5. Verify it's working

1. Open **http://localhost:3000** — you should see the login page
2. Enter your email and click "Send magic link"
3. Check the **backend terminal** — the magic link email (with URL) is printed to the console
4. Copy the URL from the terminal and open it in your browser
5. You should be logged in and redirected to the dashboard

## Documentation

APILens documentation is maintained in the `docs/` folder (Mintlify) and is currently developer-centric.

- Docs config: `docs/docs.json`
- Getting started: `docs/getting-started/introduction.mdx`
- Auth flows: `docs/auth/authentication-flow.mdx`
- Ingest API: `docs/ingest/ingest-api.mdx`
- REST endpoints: `docs/api-reference/rest-api.mdx`
- SDK guidance: `docs/sdk/building-an-sdk.mdx`
- Engineering blog: `docs/blog/`

Consumer/user-focused documentation is planned and will be published separately.

### Run docs locally

```bash
cd docs
npx mintlify dev
```

## Project Structure

```
apilens/
├── backend/                  # Django API
│   ├── api/                  # API endpoints (thin routers + schemas)
│   │   ├── auth/             # Auth endpoints (magic-link, verify, refresh)
│   │   ├── users/            # User endpoints (profile, sessions)
│   │   ├── apps/             # App CRUD + app-scoped API keys
│   │   └── ingest/           # Telemetry ingest endpoint
│   ├── apps/                 # Django apps (business logic + models)
│   │   ├── auth/             # Tokens, magic links, API keys
│   │   ├── users/            # User model and services
│   │   └── projects/         # Apps, environments, endpoints, analytics
│   ├── config/               # Django settings, URLs
│   └── core/                 # Infrastructure (auth, db, cache, exceptions, utils)
├── frontend/                 # Next.js app
│   └── src/
│       ├── app/              # App Router pages + API routes
│       ├── components/       # React components
│       └── lib/              # Utilities (session, API client)
├── docs/                     # Mintlify documentation
└── scripts/                  # Utility scripts
```

## Development

### Running both servers

You need two terminals:

```bash
# Terminal 1 — Backend
cd backend && source .venv/bin/activate && python manage.py runserver

# Terminal 2 — Frontend
cd frontend && npm run dev
```

### Magic link emails in development

By default, the backend uses Django's console email backend. When you request a magic link, the email (with the login URL) will be printed in the backend terminal. Copy the link and open it in your browser.

### Resetting the database

If you need to start fresh (e.g., after a schema change during development):

```bash
cd backend && source .venv/bin/activate

# Drop and recreate the database
sudo -u postgres psql -c "DROP DATABASE IF EXISTS apilens;"
sudo -u postgres psql -c "CREATE DATABASE apilens OWNER apilens;"

# Re-run migrations
python manage.py migrate
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `ModuleNotFoundError: No module named 'django'` | Activate the venv: `source .venv/bin/activate` |
| `uv pip install -e .` fails | Make sure you're in the `backend/` directory and using `uv` (not `pip`) |
| `FATAL: password authentication failed` | Check `backend/.env` — make sure `POSTGRES_PASSWORD` matches what you used in `CREATE USER` |
| `FATAL: database "apilens" does not exist` | Run the PostgreSQL setup commands from step 2 |
| `FATAL: role "apilens" does not exist` | Run `sudo -u postgres psql -c "CREATE USER apilens WITH PASSWORD 'apilens_password';"` |
| Frontend shows blank page | Make sure `SESSION_SECRET` is set in `frontend/.env.local` (not empty) |
| Magic link not working | Check the backend terminal output — the email with the link is printed there |

## Contributing

Contributions are welcome! This project is in its early stages, so there's plenty of room to help shape it.

1. Fork the repo
2. Create your branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Open a pull request

Since there's no first release yet, expect breaking changes. If you're unsure about an approach, open an issue first to discuss.

## License

MIT — see [LICENSE](LICENSE) for details.
