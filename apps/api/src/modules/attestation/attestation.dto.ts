import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Play Integrity proof sent by the mobile apps (see AttestationService). */
export class AttestationFields {
  @ApiPropertyOptional({ description: 'Challenge from POST /attestation/challenge (or a 428 response)' })
  @IsOptional() @IsString() @MaxLength(300)
  attestationChallenge?: string;

  @ApiPropertyOptional({ description: 'Play Integrity token requested with nonce = base64url(sha256(challenge + "|" + binding))' })
  @IsOptional() @IsString() @MaxLength(8192)
  integrityToken?: string;

  @ApiPropertyOptional({ description: 'Why the app could not obtain a token (Play services error code)' })
  @IsOptional() @IsString() @MaxLength(100) @Matches(/^[\w .:-]*$/)
  attestationError?: string;
}
