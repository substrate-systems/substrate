import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import type { GatewayTarget } from "../db";
import { ExomemHostedError } from "../errors";
import { clearContractCacheForTests, routeExomemCommand } from "../gateway";
import { SensitiveSecret, type SecretEnvelope } from "../security";

const USER_A = "018f2d91-7c42-7000-8000-000000000071";
const TENANT_A = "018f2d91-7c42-7000-8000-000000000072";
const USER_B = "018f2d91-7c42-7000-8000-000000000073";
const TENANT_B = "018f2d91-7c42-7000-8000-000000000074";

// Generated from exomem.hosted_gateway.build_gateway_contract() at release 0.19.1.
const CANONICAL_CONTRACT = JSON.parse(
  gunzipSync(
    Buffer.from(
      "H4sIAAAAAAAC/+09a4/cuJF/hehPu0BrxuNdZ7325QDHjz1f9uHYvuQOcaBhS1Q3M2pJS1Iz7jUM3I+4X3i/5KqKpESpn5J6shdgAwQ7pqQqPurNqupPs6Rcr3mR6tmTv36a8cTIssC/Z0rcSnE3+9t8lvCKL2QuzWb2BF5XYjafZVJpE6u6iDXPxOyJUbWYz5Y1V6lI40yKnCDC1+syhecAjqfwXcHXgqCUKpUFR2yxNtzUGh5WXPG1+6xSZVonJta1yniC3/D0lheJQCgILC6LfOMRq7I2gqa9CzKAM1Ko2ZOrz/NwjfeztkVZGm0Ur8IVfZqlQidKVogbXvqA+17BVD7M2BepyHidmy/n7MMsq/P8w2zOSgX/SCVfFqU2MtEfZhfsuf2ESc1EUdbLFcvgtaJUa56zJJeiMPqCvQIIjKcpvPSRr6tcwNiLFpB9VAmV4XewoUwWRqhKCUObxpa1THH8ol0SHEYmc0E7/3MtFRzCk4znGrbFbCp8AxY8w83trvIn+gMnx/NcqEiLXCRGpOyuVDdZXt6xnC9EfsHeClOrAh5wzZIS5vPRMDzfp0walpZCwyoNS1a8WAqmhboVii3Eit/KUgXz9GCPTXQnfVVKrrnaHCav9nD3EdWM65t74hqAHK/FuqRJ7iWtP9VC00ECbWjBVbJi1UpxLS7Yy3VlNmwteKGZEgnQyyWcK5w+7Dz8Gw4p2Myfa+F2Y9SRV3wpInyVWRQ6AI3D+gDoXGrzV4D/t4MIVPl3oKboRmx2oHBPJ2MxfLlrAXw5GTIwt5K/wM7rSvAbIOhtNO7JZFRcGZmh5LiRRerxMF0DaQDDVWk2Z0D7SzFnib6ds7/rsghmgawfn+XIOvPQzJQgopK8TkNZ40biyVh/4B/ZSqJEfGHlK7t6FODJ5VqaA6BBKu4AerOYs1sERhL6ZhGhmAhPLCmr4XJytVkomc4ZkDKIsJRg3wL1doQbiYShkJ2WQYCoWXBDWAqSXoacbgcGw7ZCm3Fg9eQG6NgLblRKILiAiGSx7KAR1QEkIFrzHVheF0QPbAlCdxUVQi5Xi7IGDLwAKlqC9mJ2+y7tjjmZF+ClL4cjflUqUI4IsK5AO2rQTKrUOhJFAieBS3RTeMpKICVaNp5RxO+4EozXpgwmYd8ePos3SmSADM8RGCJFPQjasEQFqPgd07AVCQwsNsxZER0ZiN/G/tvRyFG53Qo8XzgKjXrOTgA2BuSIAN0Fylrobcz2w+F4n1VVvmG1BpHE4BVt2N1KFCAsqlwm0sAzBAhqTqTbSGs9Zql/kWbFkELpDEEeOrLDr1JLfMwRn1qVZcpSbnifyGJRKJmsxhM5GGFKilvUOyCeiqUmqgrMwACjm2Hs3jyKdLzRYzmK7Jci/TUMH5rbccvnz0j/kRI5J3qtOBwpbN8fi/IOyB9o6Q9gBbXP9apUBkzKDg3BN52dtDM9RQ7i3rFMgRBcc2NQnwPuZCV4xXTCi54wDF60uz6BZmCTkQdFKs2l40mNbArSXoNE3OwgGvdkPFZZgBQGYwK2jwGh2H/cyRs4+OIGJAM4lUDJuqNwixs9HqFZCZJ4APcmLe8KNGNgFBTOjuXBi/fID5kwxA5LYQ5wQ1pWaF/cH1csVHmnxXC+0PXCKNFzB8ioYQrcm0PccIpZgKoBQwfIemifTTVhfvLwcNIgoivgatjNECz/GNP4YHPOE1daGiQnTeS8kmkqiku9Af2yBi7O065V3vIQvjfCsABMCIpp656jM+7QkMxoNhC3K7Qt7esjFknn4BTbHc+RPxfb6wJBUit9isIezzp+bfAWzilOAUlCkmgvI2lOM6or0LjiVFZys97ipRkZqQXxrWOqOyWNCHcBGGoBEznAUBRiaQTRokw36MsQIMYzkv2teL8Iw14W+UAF8x+FRJMT7ABd5RxwgQkE1APbBlIf7N9Q6SABo6j8t6vQXcUPhmJtvLa8vBMqAdXJnr17/vo1eCkLvohoIPOkjDYm2IBFyO06r5eDuR0MbbI2IjR00QzTYHOBt5WBh1IrGKloncUcrUEBJAc4yV9yBAlQorwMNS0CIkdyhINj33YeTTCxC/YFLzYMV/iU1cVNgXQA3psmsx9E7RKIG06jRDUFlAm2rPhyKzgxIbhiAViUZGeQa+KHyUk4zxzHet/vyDG5FLcSZGRijTHw+MHuCPwIloKi1ki/65BurE8zEvH3DbVikObMMRsbUCYJDR5nRzj7IPawE31lyRqcVgAJEi2E6IYGw3xjOYT0PLzX1ef4ZBw3vGz4DdTlmsswRGQHpoCE/VMGnarepipz0Js7PtVaUVg7nKwbmgJ2talKELNahhTWDk7aCVLzTMtfwq0oBqv9AGTIcd0dtk/SEXv8piNvwYpMZR1ysR2YANY5Nhjj6U3aezxTgFf1IpeJvfHogadHejUN/gr89csELKFuEA+Hp4BFH69Ul1bZdWwL+2QwbG8BO7dtubSXBxrtCnK5hO4GlYJ3hpu+z2Gnl2Dtkc7irAAjN1Bl2+H7OHEfnO9Gx33cmqSoLPdbn2cyO2GlMdqJuEL4E+YMdL3fCMXDPMGxe4MBMoyiw+sTgxg/FSICGkAf2+q6ILDgSKFrVt2tNsMDJWC+JtaVv1uVgKJjQ4fSrt2uoSabQ3E23f/yI8bPycbXhawqYXDHlcUToAB3yh/ryEmTqO4FNAJiGbsVaEZsWJmAc6fIFCsz1k62I1bpg5jn+XDOfiec3ANOQ5GdUSTe6gfQ4kthXISqozDty4OXxuEYihR8AZgy/UH2ef9EHPq4KrUcpe//wE2yspMGd4PD33cYJW4377I9nstg93pS+RDl4VXbToNTFrhzqrxDwYgUB65WCBiexPBkhAvRQu7RmuE3w63CZzle49vF47lzDNMDO+HfCDDkECBEL+eGhkzCsCoKVdwRLUznlhKGB0//R9BAoft8y/M6nDP9e/j5vRGKroQCyBURU11glCdBCxT4ASNaIT9w3MzYPR2+S29FBj6ci0PIjLlwg8ubSMGkRPZHXdi5b60oJyNecb0aYZpQmhDoclC7SzCoMC5iHKeAiqXJdMUMbKlEnXpa2HuCYkfeu3fFfkI8ycqF49r8peebyqn15n6tp2bG6PcdISsU0aiKyQoDlNMDVT86SDZC9c8ZgGrX0PWdx4eR/rLa0D7D0VnIUrOFwINuL1A7ahivzs8ZrLqnwNPFPQeLQvpsPdjfAkW/BYp+CxT9Fij6LVD0jw0U/X8M3Tjb6sjd4b2beADdgGyOrT46ZOK9bVK2+s7XSIvrnQP2z2tvYU5okos5c0krc8z4usF7PpBKc4YmQUkOPkpMtaX9z3Cz18zAocTkS8Tqk+sCnLUaniZ5H3bGO0xdckmW9lLNUZV1NnU3Thc7Ak3Hp3jaHEIrBYFbq1IDnXgDzYN3k+hQNaUexr6mYLhP2yZi06X3ClRYi3fHpLYj1cDL2+xwXjnEU9xaOwURB9PaL5lcec18kIgaXGVjd/+4XHJixNrdsLs+kYtytB2YU65pO1LmtPx6OtZddvJ9nV4/JWXQscHLlI3yj1EsmHaMxS6x94wOneHrIsGXzJyhsJl77UzyzJrdPUW9nat+gpJ46X00r94p0uNuCAhiyP67TIATkDzzdQJe3fh8XLTxQG+KoucJ+vcGZ9a8fxU9JlWMhO63G4sisDxG3nYc85EquvUJYecSDofRPu5kx7cf3Z+k8ks8RuHnEkg9gjaKF5oyw90JHyLouspLnlryvSvw7zAOBqqa3/NmNbM15Y04RZZjruf8zDvYz4RGVCcEE9EOKAzZU5SFz+3fcBprGAFOMiQhboFtgJvnTNyWeW3fCQThHN1tNI2Q9hVPZWJH6wK+BeGvRRo5PTBnNsEU3LxULIy7k3EjP9eiFhfsujtwjfnuYF9od9PMUyqnAQsQQ8hUk+Ze50kiKkPVivQl1kwajLEXGDJNgotrkEtFSvFlzZZwlJi9v9h486iiIie6xdFyiUyZgUjB6kewK2z2Z4K6CKN0SVljYaT+8imz6NEM8sDBQuTsGnalQFfHHscXDU3+/sPMfhL5FXyYfXltd4Q8JvraKAl43MfXk9Nk21pL76hRnZc1cT01XLbEcElUsC2t5eiI2rNdWBrCcqkEvdzdcWVY78sKTh1XFoJH1phcwNgxhSi1LrAy+xm5kwKQ7YkFGFozd7wttCsu4Bid6hl3FT7A+BSwbRFmAHPM/WQAk+7etqEeu5Lb58ngPS2wXiv0qCwD9T74sXTeUzPfX+3hNJCFlSjCOm+e5yBai7L8Rdjb61TqtURx2osUD1/oO8MXQEHX4mMJkuXJ5aXli8t/kem/osAFfUb2G5I2aoM+TcMb92drN7uDyhLFD/y34WCvOulwYiUqoNLRbtV9FiORCsa9i13J40HX6rTzOHACQ2xMCxwDG61eA/3FgLjsvSzsi3ZOO5bk21yWDETzCnOtjUCDK7OWcEGXkWQA+NrOXffGAabBxPoD/yjX9ZrZDBF7LZmsYCuTXhQDSzzwaYxPh5dAeDykjsFmoWu4XUVKiMe9FONL41G5kkGgoD58WypITyZCx6K23dDpyYRtcplfrkyMAS3s2KjjRWQnoukUrYH5RTWmPWSNmIj9C8fwjhdTu1j8uMg5T0bBAd8pMBfPIHEonsM6DsU0IeR0mFdszgNA1RemuCRbTtspYW6CGJmVorYnZIGDk/5f8L/ohx+iFy+eMg/P1WFi+hl9FEZvQaLl4w1rbYOuTX6kK8Ahb8I6MJQKA06+7IUn+rmSg9AeFemK0n6sVHc1SFiYuVfQTxTiU+Kkjfrfy03OpWqc6bOGR/v3Nh337RBLOSEw945mRMHR9p/ezYMh26eg+cDVyfoP6KJPRLgLZkMc0nMUx4Q45ocziagOOqNqzOLGTbDjnu/Q7qPs3/dWizf4Omt/6hsUUEy5Z25b/T8Y4Z/Qw2NauIucztZPdgRfKJ4Z54+ROGljDOueVk/x1ZG+mUXTJGQdxTIqLfp5E7cAPjqGZ5xL/s62GqIQcENtYUXB5C4pb23PB3CmnGTEiefRwnYfaYh5N0pftEvfxJOKGL4j28sojoYINvLB0uNOJHdMKbKF2kS8qHMS5YP2aqj9G5N643zXGKf7EeHTMyHZUa89zvz9rjF7d4AcZ/O+6AQSrV2di0JTVxdrkfqguWbXsFFhpK4hgnhsi7Q3QkVpmdQutwktisi6QY5Rt8XZRF/oJekeZltzUelooJJC24AGRqaAWRyUKXAIx9adzSDL6ECegsV0D+kKbmXWd9wcXJx7Z/z63CKA4wW1PmRonxCF9u73ZRHfLMYu5YylMhagM6uIczCKerFlcR2Ru4dwAL9gzgPP4Ghl32IKRscwoqYosrPkVrLaIXVxeLj2LQu6PzhXNuT3cqGQ+HJegLHbSdz2Q6NhYthNS9N3Bqty/CxlAuK0M0k7MhqibQy1JxUZ2z/FBzf1EHm9cM5bP9UPnboxiYQNvIO5cuPB2mzi3kR1p6vqUCMrvKGzEWLwG+0t0l5X5YSg8X5vAc7y2t2tUxHKNUuVBJuYHLmdiFk3f2vvtKbVtjzDALVPsmpiVY2730PbL8Ic4/O/9a5+e88YOObDt4J9gW1TG3v5f//7f4K4gfU+C2peh8VIdK8y344mtPefSkS+eEcDW9+Cms3lUlq3HLy6EhzisnNLalacrJqKrmGp5oGuQhbC3Alhk0YsoWHYwDUvwRYRHHvY5rr00/n1YhbOVYh9+yobX20D//55oyGotQ21+qMON84Jdt8faRd1T4EOAh5Ti6ejfaJ8eygqQIKTnBoUQBjuWh9jOdGaFzKDDcOcgmoTcd0mEDSXraLpFDz1VvyVbat0j62jbBcosjT1pW9n1I2Vn7lhlM1MCLpGnaFHFDZLbW6Z2U3TMQ9be3YKfeDf8bgAQWPWegrARCjjWnV3jsQ+jkeR20vXIxJ8uCVPrAfg7/GrzaXPZezHPDy9EdITbdNJCaOO2896pTBULKDxaeD/p6QT2YyhTH6ckyosEpnbCD+GX7A2OZKpPlsOC6HrZ7KcM1UFr+phMZfBWuyFc79w1XYexZ3tROI2uO2jesoiWteKTYlFLfOUYb+xNKV2n6f0OXWfxe1n46podzfU36ZVd09P/wWq+kjvu2371WlYJyux5idQsCwyqidwBozLusiyowH3E66n2hR/mycHdr5tu7V9KXUN6hVN/t9/mPl3P8yup4ZErj2s63mbZKevaZHXTZAqckEqfd2JUizOUxLaRn5pq8XWTwhMRNP0kz+CCC9JRwWtMAKAfRLBJibAeG5NWUHTRJwgdTTumA7HjdVuu3IYhh6K5X7fJoG6KZDNlDZkdTbf5nXRcIITRi4fklOnPcT9/PvXl89fY3NXUJrCtokrSNx0cpQwqWpMV1diPoebupQrMjltMUtn0WFiCkiNqsbsbJ53g20ORGzK8V5X4zbZ3njYNUWxLe7ZVWrihw7gxtzZA5caSugKWFaQqdy6bPd2qzFFI3Rl7rEOC7tzsfCT6OFZqyXAcGwTJGIXjd+rD9A68Pexc+Y7yqyB++ZgmOYCR+Hs9Sqyb9J9KSUHn+WK9k17KevrP8WlncWlR48aykkdh9rO6CzJiu+x6KG5duxM4EjNwyCxvdUQmxDtboQ9nHts9xkLM2jL1OlCg4Rwni40rqtLc+jUJK3TywUluMK7qaIsqBlKLjjeG9H9GuvEhyb2eiFJRCbMnn3Fn9gYHqm2O4mSlOJN1CIYV4loeomi9iU9Rvdhn2HRUL+lcyT5qGkHPKot8Uk+eoP2jA56kDPufgbi9mjPltPCvI2DvBc4tqAaBfytcI2Cim7zds0oJ6CDxIryuHllgsGTNafdFTOgB9YjfimCGMvCw3hCFa6IphqKGvxFjxgsiBUvJqICUyT49YvtPvsWVfvKcHTf01F4Kw+FWyqFb8WnMRrkf+1ql1GYovp2+zDSRX5PqgYzPzdWtPaVH+micbQXJLcR1M2eWBBYRXglPg5Jmx0YlsK0Oj106E/ItJ9iMVnp7G2SXudztGdum4eWwNBqIl0MBm3nM5q+88Bh42JM4nSDjSH28IQf5thrfw3Mhqfcqhh/DEULM+BHCNwXR02ZE7zvFyXdX/z7u59+ZFwpvukDtXc344joe1JQmaegkpxl3S09NYd/omtPj7jnZV6vC5sNZ53jjkCkhyNZ14KmCD6GtBadrAQYiRdj6qIURWwTQU5gr3LVDo5QC2i+naEg7A1fekVZZlm3M6AdGAySouxUJJn5WGdWF8kTezShJbdcgsM4plbnBRpbyv6oIXYw6kkkYu4pQLu2PIEc4R8TQLtqyujpg7SPzig+++n4rYwJZRxKNHT6jfRC7dNsAVDwJ7li2/IwTnKutf9hUPqdU5BAIG3JUydRhdlffiwqVWQ/xLKk4lbkYOq3I5ry6iOhVLnrE5hPD72O3Y7Eza+SgkhVJRgStfHL9K5+7CMATubGa76JFyLmadrKwarMZbKhjUsl/bbWZ9AYEr1+XD7PMShuVmvc9BV/+Oh3MG1bL/dk9u3jr5Kvv/76m+ybb0T21VVydfXg28Wj3z0SD66+/lY8ePRV+vDhw/TxNzzli8Xjr9NHi68WyVePHl+lV2kmxENE5TdFIzbaiOaPuD193GyK/q+F1j4ZBds8NcVb4bu6TrCSGLecAMJjmDsSToAisbrHHUEPfOOmRhk4YdFurE+KOs8/zxt0lkY/hyOf9szLU14zLRp4EpCUtjerDSQ8rc8I29Zg4OWwAHUH3zy4uPr24sqWtZkSWMeXs8AzHHaxlWbwat6WoS/hD3vONdiCRWItPkQQYbsokUb+Vdwc/jE2Jo81hupRhX/74MG8DVgQT/i6eorS0x+wyhb1Z8RdU90pdupFLYdHIfIcEP9n9NKifg7/jl4jDJmKdVXCQRCJvm7/Ff2RKkHxqj6RFe98/sYPRu9cVrDfme5bdiz6s5udpSGi+/YtF0zD2Xz+/H/A/4nl23gAAA=",
      "base64"
    )
  ).toString("utf8")
) as TestContract;

type TestContract = {
  schema_version: number;
  protocol_version: string;
  exomem_release: string;
  commands: Array<{
    name: string;
    params: Array<{ name: string; type: string; required: boolean }>;
    read_only: boolean;
    mode: "read" | "write";
    tier: number;
    capability: string;
    guarded_fields: string[];
  }>;
  digest: { algorithm: "sha256"; value: string };
  [key: string]: unknown;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
}

function contract(tamperDigest = false): TestContract {
  const value = structuredClone(CANONICAL_CONTRACT);
  if (tamperDigest) value.digest.value = "0".repeat(64);
  return value;
}

function alteredContract(mutate: (value: TestContract) => void): TestContract {
  const value = contract();
  mutate(value);
  const { digest: _digest, ...unsigned } = value;
  value.digest.value = createHash("sha256")
    .update(JSON.stringify(canonicalize(unsigned)))
    .digest("hex");
  return value;
}

function target(input: {
  userId: string;
  tenantId: string;
  cellId: string;
  endpoint: string;
  capabilities?: string[];
}): GatewayTarget {
  return {
    userId: input.userId,
    tenantId: input.tenantId,
    tenantStatus: "active",
    tenantDesiredState: "running",
    cellId: input.cellId,
    cellLifecycleState: "active",
    cellRoutingState: "bound",
    protocolVersion: "1",
    releaseVersion: "0.19.1",
    credentialCiphertext: { value: `credential-${input.cellId}` },
    endpointCiphertext: { value: input.endpoint },
    entitlementSource: "complimentary",
    entitlementSourceState: "complimentary_active",
    entitlementEffectiveState: "active",
    capabilities: input.capabilities ?? ["capture", "recall", "export"],
    resourceLimits: {
      storageBytes: 1024,
      uploadBytes: 512,
      workerCount: 0,
    },
    manuallySuspended: false,
  };
}

function decrypt(envelope: SecretEnvelope): SensitiveSecret {
  return new SensitiveSecret(String((envelope as unknown as { value: string }).value));
}

beforeEach(clearContractCacheForTests);

describe("registry-derived Exomem gateway", () => {
  it("keeps identical paths and idempotency keys isolated to the mapped cell", async () => {
    const targets = new Map([
      [
        TENANT_A,
        target({
          userId: USER_A,
          tenantId: TENANT_A,
          cellId: "cell-a",
          endpoint: "https://cell-a.internal/",
        }),
      ],
      [
        TENANT_B,
        target({
          userId: USER_B,
          tenantId: TENANT_B,
          cellId: "cell-b",
          endpoint: "https://cell-b.internal/",
        }),
      ],
    ]);
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, headers });
      if (url.endsWith("/contract")) return Response.json(contract());
      const cell = new URL(url).hostname.startsWith("cell-a") ? "cell-a" : "cell-b";
      return Response.json({ success: true, data: { cell } });
    };
    const resolveTarget = async (session: { tenantId: string }) =>
      targets.get(session.tenantId) ?? null;

    const first = await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "remember",
      args: { title: "Same", content: "same path" },
      idempotencyKey: "same-public-key",
      dependencies: {
        resolveTarget,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
      },
    });
    const second = await routeExomemCommand({
      session: { userId: USER_B, tenantId: TENANT_B },
      commandName: "remember",
      args: { title: "Same", content: "same path" },
      idempotencyKey: "same-public-key",
      dependencies: {
        resolveTarget,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "B".repeat(43),
      },
    });

    assert.deepEqual(first.body, { success: true, data: { cell: "cell-a" } });
    assert.deepEqual(second.body, { success: true, data: { cell: "cell-b" } });
    const commandCalls = calls.filter((call) => call.url.includes("/command/"));
    assert.equal(commandCalls.length, 2);
    assert.equal(commandCalls[0].headers.get("x-exomem-cell-id"), "cell-a");
    assert.equal(commandCalls[1].headers.get("x-exomem-cell-id"), "cell-b");
    assert.equal(commandCalls[0].headers.get("idempotency-key"), "same-public-key");
    assert.equal(commandCalls[1].headers.get("idempotency-key"), "same-public-key");
    assert.notEqual(
      commandCalls[0].headers.get("x-exomem-principal-scope"),
      commandCalls[1].headers.get("x-exomem-principal-scope")
    );
  });

  it("rejects nested routing selectors before resolving or contacting a cell", async () => {
    let resolutions = 0;
    let calls = 0;
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "remember",
        args: {
          title: "selector",
          content: "safe",
          metadata: { tenant_id: TENANT_B },
        },
        idempotencyKey: "selector-test",
        dependencies: {
          resolveTarget: async () => {
            resolutions += 1;
            return null;
          },
          fetch: async () => {
            calls += 1;
            return Response.json({});
          },
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "HOSTED_SELECTOR_REJECTED"
    );
    assert.equal(resolutions, 0);
    assert.equal(calls, 0);
  });

  it("retries a lost mutation acknowledgement only against the same cell", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    let commandCalls = 0;
    const seenHeaders: Headers[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/contract")) return Response.json(contract());
      commandCalls += 1;
      seenHeaders.push(new Headers(init?.headers));
      if (commandCalls === 1) throw new Error("lost acknowledgement");
      return Response.json({ success: true, data: { replayed: true } });
    };
    const result = await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "remember",
      args: { title: "Retry", content: "once" },
      idempotencyKey: "retry-once",
      dependencies: {
        resolveTarget: async () => row,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
      },
    });
    assert.equal(commandCalls, 2);
    assert.deepEqual(result.body, { success: true, data: { replayed: true } });
    assert.equal(
      seenHeaders[0].get("x-exomem-request-id"),
      seenHeaders[1].get("x-exomem-request-id")
    );
    assert.equal(seenHeaders[0].get("idempotency-key"), "retry-once");
  });

  it("fails closed for a tampered contract and absent capabilities", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
      capabilities: ["recall"],
    });
    const dependencies = {
      resolveTarget: async () => row,
      expectedProtocol: "1",
      decrypt,
      principalScope: () => "A".repeat(43),
    };
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "anything" },
        dependencies: {
          ...dependencies,
          fetch: async () => Response.json(contract(true)),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_RESPONSE_INVALID"
    );

    clearContractCacheForTests();
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "remember",
        args: { title: "Denied", content: "no capture" },
        idempotencyKey: "denied-write",
        dependencies: {
          ...dependencies,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(contract())
              : Response.json({ success: true, data: {} }),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "EXOMEM_ENTITLEMENT_DENIED"
    );
  });

  it("rejects contradictory read metadata before using it for retry or mutation policy", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    const contradictory = alteredContract((value) => {
      const command = value.commands.find((candidate) => candidate.name === "ask_memory");
      assert.ok(command);
      command.read_only = false;
    });

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "anything" },
        idempotencyKey: "contradictory-read-mode",
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(contradictory)
              : Response.json({ success: true, data: {} }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_RESPONSE_INVALID"
    );
  });

  it("rejects self-consistent semantic drift from the pinned 0.19.1 registry", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    const drifted = alteredContract((value) => {
      const command = value.commands.find((candidate) => candidate.name === "remember");
      assert.ok(command);
      command.guarded_fields = [];
    });
    assert.notEqual(
      drifted.digest.value,
      "983c4447f77ef31c1109b565e0149e053d222d87adabb84d5b3bc3581d1dfee2"
    );

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "remember",
        args: { title: "Drift", content: "must not execute" },
        idempotencyKey: "semantic-drift",
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(drifted)
              : Response.json({ success: true, data: {} }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_PROTOCOL_MISMATCH"
    );
  });

  it("does not let a cached contract hide an immediately altered digest", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    let contractCalls = 0;
    let commandCalls = 0;
    const drifted = alteredContract((value) => {
      const command = value.commands.find((candidate) => candidate.name === "ask_memory");
      assert.ok(command);
      command.capability = "unexpected-capability";
    });
    const fetchMock: typeof fetch = async (input) => {
      if (String(input).endsWith("/contract")) {
        contractCalls += 1;
        return Response.json(contractCalls === 1 ? contract() : drifted);
      }
      commandCalls += 1;
      return Response.json({ success: true, data: {} });
    };
    const dependencies = {
      resolveTarget: async () => row,
      fetch: fetchMock,
      expectedProtocol: "1",
      decrypt,
      principalScope: () => "A".repeat(43),
    };

    await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "ask_memory",
      args: { query: "first" },
      dependencies,
    });
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "second" },
        dependencies,
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_PROTOCOL_MISMATCH"
    );
    assert.equal(contractCalls, 2);
    assert.equal(commandCalls, 1);
  });
});
