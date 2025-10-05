
FROM node:22-alpine

WORKDIR /src

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Expose port
EXPOSE 5173

# Start development server (already has --host 0.0.0.0 in package.json)
CMD ["npm", "run", "dev"]