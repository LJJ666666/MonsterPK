import { PrismaClient } from '@prisma/client';

// 单例 PrismaClient，避免热重载时反复建连。
export const prisma = new PrismaClient();
