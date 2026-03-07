# OpenPalm Memory API — lightweight wrapper around mem0 Python SDK
#
# Build context must be the repo root (context: .) so compose.dev.yaml paths work.

FROM python:3.12-slim

LABEL org.opencontainers.image.name="openpalm/memory"

RUN groupadd -g 1000 memory && useradd -u 1000 -g memory -d /home/memory -m memory

WORKDIR /app

COPY core/memory/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY core/memory/main.py .

RUN chown -R memory:memory /app

USER memory

EXPOSE 8765
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765"]
