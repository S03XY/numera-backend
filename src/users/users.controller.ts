import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get the authenticated user profile.' })
  me(@CurrentUser('userId') userId: string) {
    return this.users.getById(userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the authenticated user profile.' })
  updateMe(@CurrentUser('userId') userId: string, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(userId, dto);
  }

  @Public()
  @Get(':address')
  @ApiOperation({ summary: 'Get a public profile by wallet address.' })
  byAddress(@Param('address') address: string) {
    return this.users.getPublicByAddress(address);
  }
}
