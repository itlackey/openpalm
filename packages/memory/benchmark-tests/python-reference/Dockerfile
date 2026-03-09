FROM python:3.12-slim

LABEL org.opencontainers.image.name="openpalm/memory-python-ref"

RUN groupadd -g 1000 memory && useradd -u 1000 -g memory -d /home/memory -m memory

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

RUN chown -R memory:memory /app

USER memory

EXPOSE 8765
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8765"]
