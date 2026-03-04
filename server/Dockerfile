FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY server/requirements.txt /tmp/requirements.txt

RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && pip install --no-cache-dir moonshine-voice==0.0.49

COPY server/app.py /app/app.py

EXPOSE 8765

CMD ["python", "/app/app.py"]
