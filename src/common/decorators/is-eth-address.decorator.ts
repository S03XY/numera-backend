import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { isAddress } from 'viem';

/** class-validator constraint asserting a value is a valid 0x EVM address. */
export function IsEthAddress(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isEthAddress',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isAddress(value, { strict: false }),
        defaultMessage: (args: ValidationArguments) =>
          `${args.property} must be a valid EVM (0x) address`,
      },
    });
  };
}
