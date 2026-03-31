/**
 * S08_Close — Minimal Close (300 frames / 10s)
 *
 * Near-empty frame. 3 elements max.
 * Under 25 words total on screen.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import {
  C,
  F,
  SIZE,
  SafeFrame,
  VStack,
  T,
  Reveal,
  Spacer,
} from "../lib";

export const S08_Close: React.FC = () => {
  return (
    <SafeFrame justify="center" align="center" gap={32}>
      {/* Three-line tagline */}
      <Reveal at={18}>
        <VStack gap={4} align="center">
          <T
            font={F.monument}
            size={SIZE.title}
            color={C.fg}
            weight={700}
            tracking="0.04em"
            align="center"
            style={{ lineHeight: 1.2 }}
          >
            Physical work, composable.
          </T>
          <T
            font={F.monument}
            size={SIZE.title}
            color={C.fg}
            weight={700}
            tracking="0.04em"
            align="center"
            style={{ lineHeight: 1.2 }}
          >
            Verified by protocol.
          </T>
          <T
            font={F.monument}
            size={SIZE.title}
            color={C.accent1}
            weight={700}
            tracking="0.04em"
            align="center"
            style={{ lineHeight: 1.2 }}
          >
            Owned by operators.
          </T>
        </VStack>
      </Reveal>

      <Spacer height={24} />

      {/* URL */}
      <Reveal at={90}>
        <T font={F.swiss} size={SIZE.subtitle} color={C.accent1} align="center">
          capability.network
        </T>
      </Reveal>

      {/* CTA */}
      <Reveal at={150}>
        <T font={F.express} size={SIZE.body} color={C.muted} align="center" weight={300}>
          Join the operator beta.
        </T>
      </Reveal>
    </SafeFrame>
  );
};

export default S08_Close;
