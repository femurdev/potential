FROM python:3.10-slim

# Install build tooling
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user for running compilation inside container
RUN useradd -m -s /bin/bash builder

WORKDIR /workspace

# Copy compile entrypoint and make executable
COPY ./project/scripts/compile_in_container.py /usr/local/bin/compile_in_container.py
RUN chmod +x /usr/local/bin/compile_in_container.py

# Ensure the workspace dir is owned by the non-root user
RUN chown -R builder:builder /workspace

USER builder

ENTRYPOINT ["/usr/local/bin/compile_in_container.py"]
