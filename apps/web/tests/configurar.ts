// Configuração dos testes de componente (Testing Library + jsdom).
//
// Registramos os verificadores de DOM do jest-dom (toBeDisabled,
// toBeInTheDocument...) no `expect` DESTE Vitest. O atalho
// "@testing-library/jest-dom/vitest" registra no vitest que o próprio
// pacote encontra; num monorepo, dependendo de onde o npm instala cada
// pacote, pode ser outra cópia, e os verificadores "somem".
import { afterEach, expect } from 'vitest';
import * as verificadores from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
// Só os TIPOS (o TypeScript passa a conhecer toBeDisabled etc.); some na compilação.
import type {} from '@testing-library/jest-dom/vitest';

expect.extend(verificadores);
afterEach(() => cleanup());
