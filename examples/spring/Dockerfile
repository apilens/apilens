# APILens example app: Spring Boot + the Java SDK from this repo.
# Build context is the repo root (see deploy/compose/compose.examples.yaml).
FROM maven:3.9.16-eclipse-temurin-21@sha256:99e61abcff91a9b1333463bd8451fb18495d6eba9250ac66a338b518f8278320 AS build
WORKDIR /repo
COPY packages/sdk-java/pom.xml packages/sdk-java/pom.xml
COPY packages/sdk-java/src/main packages/sdk-java/src/main
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B -ntp -q -f packages/sdk-java/pom.xml install \
      -DskipTests -Dmaven.test.skip=true -Dmaven.javadoc.skip=true -Dmaven.source.skip=true
COPY examples/spring/pom.xml examples/spring/pom.xml
COPY examples/spring/src examples/spring/src
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B -ntp -q -f examples/spring/pom.xml package -DskipTests

FROM eclipse-temurin:21.0.13_9-jre-alpine@sha256:82cf3d9ccbe1ed46252008d51b2f2329e6b9e8a2f4394c4bebefc3ea7f4b1372
WORKDIR /app
COPY --from=build /repo/examples/spring/target/app.jar ./app.jar
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=30 --start-period=20s \
  CMD ["wget", "-qO-", "http://127.0.0.1:8080/health"]
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/app.jar"]
