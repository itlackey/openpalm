# OpenPalm Memory API — built from upstream mem0/openmemory source
#
# Build context must be the repo root (context: .) so that both vendor/
# and core/assets/ paths are available.

FROM python:3.12-slim

LABEL org.opencontainers.image.name="openpalm/memory-api"

WORKDIR /usr/src/openmemory

# Install dependencies from upstream source
COPY vendor/mem0/openmemory/api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy upstream application code
COPY vendor/mem0/openmemory/api/ .

# Apply OpenPalm patch: embedded Qdrant + SQLite support via config file.
# Replaces upstream memory.py which hardcodes host-based Qdrant.
COPY core/assets/openmemory-memory.py ./app/utils/memory.py

EXPOSE 8765
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765"]
