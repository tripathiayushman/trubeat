# Fallback path (same app.py + requirements.txt as the Gradio-SDK Space):
# if the stock Gradio runtime conflicts with the tool's pins, redeploy this
# folder with sdk: docker in the README metadata and this Dockerfile runs:
#   pip install -r requirements.txt   (tool from GitHub, model in the wheel)
#   python app.py                     (listens on 0.0.0.0:7860)
FROM python:3.11-slim

RUN useradd -m -u 1000 user

USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR /app

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

COPY --chown=user app.py .

EXPOSE 7860

CMD ["python", "app.py"]
