/**
 * Maps upload-parsing failures to proper HTTP responses.
 *
 * Nest translates Multer errors by comparing the error MESSAGE text, which silently breaks when a
 * patched Multer release rewords a message (Multer 2.5 renamed "Unexpected field" to "Unexpected
 * file field", which made over-limit and unexpected-field uploads return 500). This filter keys on
 * the stable error CODE instead, so it keeps working across Multer versions.
 */
import { ArgumentsHost, BadRequestException, Catch, HttpException, PayloadTooLargeException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

const MULTER_MESSAGES: Record<string, string> = {
  LIMIT_FILE_SIZE: 'File too large (maximum 20 MB per image)',
  LIMIT_FILE_COUNT: 'Too many files',
  LIMIT_UNEXPECTED_FILE: 'Unexpected file field, or more files than allowed for this field',
  LIMIT_PART_COUNT: 'Too many form parts',
  LIMIT_FIELD_KEY: 'A form field name is too long',
  LIMIT_FIELD_VALUE: 'A form field value is too long',
  LIMIT_FIELD_COUNT: 'Too many form fields',
  LIMIT_FIELD_NESTING: 'Form field names are nested too deeply',
  LIMIT_FIELD_ARRAY_INDEX: 'A form field array index is too large',
  MISSING_FIELD_NAME: 'A form field is missing its name'
};

// Parser-level failures from malformed multipart bodies (thrown as plain Errors by the multipart parser)
const MALFORMED_MULTIPART = /^(unexpected end of (form|file)|malformed|multipart:|missing initial boundary|part terminator|unsupported content type|boundary)/i;

@Catch()
export class UploadErrorFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const e = exception as { name?: string; code?: string; message?: string } | null;
    if (e && !(e instanceof HttpException)) {
      if (e.name === 'MulterError') {
        const message = MULTER_MESSAGES[e.code || ''] || 'Invalid upload';
        return super.catch(
          e.code === 'LIMIT_FILE_SIZE' ? new PayloadTooLargeException(message) : new BadRequestException(message),
          host
        );
      }
      if (typeof e.message === 'string' && MALFORMED_MULTIPART.test(e.message)) {
        return super.catch(new BadRequestException('Malformed multipart/form-data request'), host);
      }
    }
    return super.catch(exception, host);
  }
}
