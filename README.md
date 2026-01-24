# ObserveX

[![CI](https://github.com/YOUR_ORG/observex/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_ORG/observex/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**ObserveX** is a modern observability platform for monitoring metrics, logs, and traces. Built with Django, React, ClickHouse, and PostgreSQL.

## Quick Start

```bash
# Clone the repository
git clone https://github.com/YOUR_ORG/observex.git
cd observex

# Run quickstart (Docker only required)
./scripts/quickstart.sh
```

Access the application at http://localhost

## Features

- **Metrics** - Time-series metrics collection and visualization
- **Logs** - Structured log aggregation and search
- **Traces** - Distributed tracing support
- **Multi-tenant** - Secure tenant isolation with Auth0
- **Real-time** - Live dashboards and alerts
- **Self-hosted** - Deploy on your own infrastructure

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Load Balancer                            │
│                           (Nginx)                                │
└─────────────────────────┬───────────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │ Frontend │    │  API     │    │  Worker  │
    │ (React)  │    │ (Django) │    │ (Celery) │
    └──────────┘    └────┬─────┘    └────┬─────┘
                         │               │
         ┌───────────────┼───────────────┤
         │               │               │
         ▼               ▼               ▼
   ┌──────────┐    ┌──────────┐    ┌──────────┐
   │PostgreSQL│    │ClickHouse│    │  Redis   │
   │ (Config) │    │ (Metrics)│    │ (Cache)  │
   └──────────┘    └──────────┘    └──────────┘
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend API | Django 5 + Django Ninja |
| Frontend | React 18 + Vite + TypeScript |
| Analytics DB | ClickHouse |
| Config DB | PostgreSQL |
| Cache/Queue | Redis |
| Task Queue | Celery |
| Auth | Auth0 |

## System Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 4 GB | 8+ GB |
| Storage | 20 GB | 100+ GB SSD |
| Docker | 20.10+ | Latest |

## Installation

### Option 1: Docker (Recommended)

```bash
# Development
docker-compose up -d

# Production
docker-compose -f docker-compose.prod.yml up -d
```

### Option 2: Local Development

```bash
# Run setup script
./scripts/setup-dev.sh

# Or manually:
# 1. Install dependencies
uv sync --extra dev
cd static && npm install && cd ..

# 2. Start services
docker-compose up -d

# 3. Run migrations
cd src && python manage.py migrate

# 4. Start servers
python manage.py runserver  # Backend
cd ../static && npm run dev  # Frontend
```

### Option 3: Production VM

```bash
./scripts/deploy-vm.sh your-domain.com admin@email.com
```

## Development

### Running the Backend

```bash
source .venv/bin/activate
cd src
python manage.py runserver
```

API available at http://localhost:8000/api/v1/

### Running the Frontend

```bash
cd static
npm run dev
```

Frontend available at http://localhost:3000

### Running Tests

```bash
# All tests
./scripts/test.sh

# Backend only
cd src && pytest

# Frontend only
cd static && npm test
```

### Code Quality

```bash
# Linting
ruff check src/
cd static && npm run lint

# Formatting
black src/
cd static && npm run format
```

## Project Structure

```
observex/
├── src/                    # Django backend
│   ├── api/               # API endpoints
│   │   └── v1/           # API version 1
│   ├── apps/             # Django apps
│   ├── config/           # Django settings
│   │   └── settings/     # Environment configs
│   ├── core/             # Shared utilities
│   │   ├── auth/        # Authentication
│   │   └── database/    # Database clients
│   └── tests/            # Test files
├── static/                # React frontend
│   ├── src/              # Source code
│   └── dist/             # Build output
├── infrastructure/        # Deployment configs
│   ├── docker/           # Dockerfiles
│   └── systemd/          # Service files
├── scripts/               # Utility scripts
├── docker-compose.yml     # Development services
└── docker-compose.prod.yml # Production services
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Key variables:
- `DJANGO_SECRET_KEY` - Django secret key
- `POSTGRES_*` - PostgreSQL connection
- `CLICKHOUSE_*` - ClickHouse connection
- `AUTH0_*` - Auth0 configuration
- `VITE_*` - Frontend configuration

## API Documentation

When running, access API docs at:
- Swagger UI: http://localhost:8000/api/v1/docs
- OpenAPI JSON: http://localhost:8000/api/v1/openapi.json

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License - see [LICENSE](LICENSE) for details.
