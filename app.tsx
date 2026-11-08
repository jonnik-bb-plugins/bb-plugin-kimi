import { definePluginApp } from "@get-bb/plugin-sdk/app";

function KimiIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      {/* Original crescent-and-star mark (Kimi = Moonshot AI), drawn as a
          currentColor mask so it follows the bb theme. */}
      <path
        fillRule="evenodd"
        d="M13.6 8.6A5.6 5.6 0 1 1 2.4 8.6 5.6 5.6 0 1 1 13.6 8.6ZM15 6.9A4.6 4.6 0 1 1 5.8 6.9 4.6 4.6 0 1 1 15 6.9Z"
      />
      <path d="M13.15 2.6A0.85 0.85 0 1 1 11.45 2.6 0.85 0.85 0 1 1 13.15 2.6Z" />
    </svg>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_providerIcon({
    providerKind: "agent",
    providerId: "acp-kimi",
    icon: KimiIcon,
  });
});
