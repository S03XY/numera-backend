import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeAddress } from '../common/utils/address';
import { UpdateProfileDto } from './dto/update-profile.dto';

export interface PublicProfile {
  address: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getById(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('user not found');
    return {
      id: user.id,
      address: user.address,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt.toISOString(),
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        displayName: dto.displayName,
        avatarUrl: dto.avatarUrl,
      },
    });
    return {
      id: user.id,
      address: user.address,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    };
  }

  /** Public, non-sensitive profile by wallet address. */
  async getPublicByAddress(rawAddress: string): Promise<PublicProfile> {
    const address = normalizeAddress(rawAddress);
    const user = await this.prisma.user.findUnique({ where: { address } });
    if (!user) throw new NotFoundException('user not found');
    return {
      address: user.address,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
