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

## Setting Up PostgreSQL

### macOS (Homebrew)

```bash
brew install postgresql@16
brew services start postgresql@16

# Create the database and user
psql postgres -c "CREATE USER apilens WITH PASSWORD 'apilens_password';"
psql postgres -c "CREATE DATABASE apilens OWNER apilens;"
```

### Ubuntu / Debian

```bash
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql

sudo -u postgres psql -c "CREATE USER apilens WITH PASSWORD 'apilens_password';"
sudo -u postgres psql -c "CREATE DATABASE apilens OWNER apilens;"
```

### Using an existing PostgreSQL instance

If you already have PostgreSQL running, just create a database and update the credentials in `backend/.env`.

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/apilens/apilens.git
cd apilens
```

### 2. Backend setup

```bash
cd backend

# Create virtual environment and install dependencies
uv venv
source .venv/bin/activate   # On Windows: .venv\Scripts\activate
uv pip install -e .

# Create your environment file
cp .env.example .env
# Edit .env with your PostgreSQL credentials
```

Open `backend/.env` and update the database section to match your PostgreSQL setup:

```
POSTGRES_DB=apilens
POSTGRES_USER=apilens
POSTGRES_PASSWORD=apilens_password
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
```

Then run migrations and start the server:

```bash
python manage.py migrate
python manage.py runserver
```

The backend API will be available at **http://localhost:8000/api/v1/**

API docs (Swagger): **http://localhost:8000/api/v1/docs**

### 3. Frontend setup

Open a new terminal:

```bash
cd frontend

# Install dependencies
npm install

# Create your environment file
cp .env.example .env.local
```

The defaults in `.env.example` work for local development. Then start the dev server:

```bash
npm run dev
```

The frontend will be available at **http://localhost:3000**

## Project Structure

```
apilens/
├── backend/                  # Django API
│   ├── api/                  # API endpoints (thin routers + schemas)
│   │   ├── auth/             # Auth endpoints (magic-link, verify, refresh)
│   │   └── users/            # User endpoints (profile, sessions, api-keys)
│   ├── apps/                 # Django apps (business logic)
│   │   ├── auth/             # Tokens, magic links, API keys
│   │   └── users/            # User model and services
│   ├── config/               # Django settings, URLs
│   └── core/                 # Infrastructure (auth, exceptions, utils)
├── frontend/                 # Next.js app
│   └── src/
│       ├── app/              # App Router pages + API routes
│       ├── components/       # React components
│       └── lib/              # Utilities (session, API client)
├── docs/                     # Documentation assets
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

## Contributing

Contributions are welcome! This project is in its early stages, so there's plenty of room to help shape it.

1. Fork the repo
2. Create your branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Open a pull request

Since there's no first release yet, expect breaking changes. If you're unsure about an approach, open an issue first to discuss.

## License

MIT — see [LICENSE](LICENSE) for details.
