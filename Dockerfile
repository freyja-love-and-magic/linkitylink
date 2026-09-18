FROM node:22.14.0

WORKDIR /usr/src/app

# Clone linkitylink repo
RUN git clone https://github.com/freyja-love-and-magic/linkitylink.git

# Install dependencies
WORKDIR /usr/src/app/linkitylink
RUN npm install

# Expose port
EXPOSE 3010

# Set environment variables
ENV PORT=3010
ENV BDO_BASE_URL=http://localhost:3003

# Start server
CMD ["node", "server.js"]
