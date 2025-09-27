FROM node:latest

WORKDIR /src

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Expose port
EXPOSE 3000

# Set environment to development
ENV NODE_ENV=development

# Start the application in development mode
CMD ["npm", "run", "dev"]