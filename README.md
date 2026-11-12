# Meme Generator Backend (`memeEngine_be`)

High-performance NestJS backend engine leveraging `@napi-rs/canvas` for server-side dynamic meme composition and MongoDB for state persistence.

## Features

- **Dynamic Layout Engine**: Standardized archetypes (Trending News, Comparison Columns, Facts Collage, Movie Updates, Stacked Comparison).
- **Multilingual Canvas Typography**: Native text wrapping, metrics calculation, and rendering with embedded fonts (Mandali, Ramabhadra, Noto Sans Telugu, Intrepid ExtraBold, Impact, Anton, Arial Black).
- **Intelligent Image Processing**: Automatic focal-point aspect-ratio cropping, badge rendering, watermark stamping, and dual JPEG/PNG outputs.
- **Meme Lifecycle & Regeneration**: Versioned regeneration pipeline (`v1`, `v2`, `v3`, etc.) with MongoDB persistence.
- **RESTful API**: Endpoints for meme creation, image uploads, regeneration, fetching, listing, and deletion.

## Tech Stack

- NestJS 10 (Express platform)
- TypeScript
- `@napi-rs/canvas`
- MongoDB & Mongoose
- Multer

## Getting Started

### Prerequisites

- Node.js (v18+)
- MongoDB running locally at `mongodb://localhost:27017/meme_engine` (or configured via environment)

### Setup & Run

```bash
# Install dependencies
npm install

# Start backend server
npx ts-node src/main.ts
```

The API server runs on `http://localhost:3000`.
