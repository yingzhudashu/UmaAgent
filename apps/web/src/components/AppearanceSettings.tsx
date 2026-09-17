export function AppearanceSettings({
  value,
  change,
}: {
  value: "light" | "dark" | "system";
  change: (value: "light" | "dark" | "system") => void;
}) {
  return (
    <section className="settings-section appearance-settings">
      <h3>外观</h3>
      <p>仅保存本机偏好。</p>
      <fieldset>
        <legend>颜色主题</legend>
        <div className="theme-choices">
          {(["light", "dark", "system"] as const).map((item) => (
            <label key={item}>
              <span className={`theme-preview ${item}`} />
              <input
                type="radio"
                name="appearance"
                value={item}
                checked={value === item}
                onChange={() => change(item)}
              />
              {{ light: "浅色", dark: "深色", system: "跟随系统" }[item]}
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
