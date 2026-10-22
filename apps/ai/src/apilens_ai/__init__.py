"""APILens AI/ML service.

Milestone 1 ships only the service skeleton (health endpoints, config,
packaging). The real features land in M4:

* Agents built on Pydantic AI with bring-your-own model providers
  (Anthropic, OpenAI, Google, Bedrock, Ollama or any OpenAI-compatible server).
* Anomaly baselines and forecasts with statsforecast, written back for the Go
  alert evaluator to compare against.
* No database credentials: every data access goes through the Go API with a
  short-lived, user-scoped token, so the service can never see more than the
  user it acts for.
"""

__version__ = "0.1.0"
