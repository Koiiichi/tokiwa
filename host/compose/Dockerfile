ARG BASE
FROM ${BASE}
WORKDIR /app
COPY requirements.lock /app/
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
COPY app.py integration.py independence.py /app/
RUN chmod 0644 /app/app.py /app/integration.py /app/independence.py
RUN mkdir /receipts && chown 1000:1000 /receipts
USER 1000:1000
CMD ["python", "-u", "/app/app.py"]
