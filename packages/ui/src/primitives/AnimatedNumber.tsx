import NumberFlow, { type Format } from "@number-flow/react";

export interface AnimatedNumberProps {
  value: number;
  prefix?: string;
  suffix?: string;
  format?: Format;
  className?: string;
}

export function AnimatedNumber({ value, prefix, suffix, format, className }: AnimatedNumberProps) {
  return (
    <NumberFlow
      value={value}
      prefix={prefix}
      suffix={suffix}
      format={format}
      className={className}
      willChange
      animated
    />
  );
}
