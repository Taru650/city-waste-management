import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { Public } from '../../common/decorators';
import { AuthThrottle } from '../../common/throttle';
import { AttestationPurpose, AttestationService } from './attestation.service';

class ChallengeDto {
  @ApiProperty({ enum: ['register', 'forgot-password', 'device'] }) @IsIn(['register', 'forgot-password', 'device'])
  purpose: AttestationPurpose;
}

@ApiTags('attestation')
@Controller('attestation')
export class AttestationController {
  constructor(private readonly attestation: AttestationService) {}

  /** Stateless (nothing stored), so it is safe to leave public; throttled like the auth endpoints. */
  @Public() @AuthThrottle()
  @Post('challenge') @HttpCode(200)
  challenge(@Body() dto: ChallengeDto) {
    return this.attestation.issueChallenge(dto.purpose);
  }
}
