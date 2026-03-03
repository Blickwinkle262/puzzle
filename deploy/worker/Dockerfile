FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1

RUN pip install --no-cache-dir uv

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY scripts ./scripts
COPY materials ./materials
COPY backend ./backend

RUN mkdir -p /app/backend/data

CMD ["uv", "run", "python", "scripts/story_generator_pipeline/queue_worker.py"]
