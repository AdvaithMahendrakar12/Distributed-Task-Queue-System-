import 'dotenv/config';
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';

export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
export const prisma = new PrismaClient();
