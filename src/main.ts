import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

// Make BigInt JSON-serializable everywhere (Prisma BigInt fields, viem values).
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const cfg = app.get(AppConfigService);

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: cfg.app.corsOrigins.includes('*') ? true : cfg.app.corsOrigins,
    credentials: true,
  });

  // Probes sit outside the /api prefix so orchestrators can reach them at a
  // stable path. All three, not two: an ops endpoint that answers on a
  // different prefix than its siblings is a trap for whoever wires the alert.
  app.setGlobalPrefix('api', { exclude: ['health', 'health/ready', 'health/indexer'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  if (!cfg.isProduction) {
    const swagger = new DocumentBuilder()
      .setTitle('Prediction Market API')
      .setDescription('Private prediction marketplace backend (Monad + Unlink).')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const doc = SwaggerModule.createDocument(app, swagger);
    SwaggerModule.setup('api/docs', app, doc);
  }

  await app.listen(cfg.app.port, '0.0.0.0');
  const logger = app.get(PinoLogger);
  logger.log(`API listening on :${cfg.app.port} (${cfg.app.nodeEnv})`);
}

void bootstrap();
