# Focus Web UI container (spec 002-focus-web-ui, task T6).
#
# Stock official Node base image. The app is standard-library only: there is no
# package.json with runtime dependencies and none should be added, so this image
# installs nothing. It just copies the runtime source and runs the server.
FROM node:22-alpine

# Application working directory inside the image.
WORKDIR /app

# Copy only the source the server needs at runtime.
#   server.js      the HTTP server entrypoint
#   lib/           the session model (requires ../focus.js)
#   public/        the static UI assets served by the server
#   focus.js       reused by lib/session.js, so it must be present
COPY server.js ./server.js
COPY focus.js ./focus.js
COPY lib ./lib
COPY public ./public

# The server listens on PORT (default 3000) and logs the bound port on startup.
EXPOSE 3000

# Start the server. No build step, no dependency install.
CMD ["node", "server.js"]
