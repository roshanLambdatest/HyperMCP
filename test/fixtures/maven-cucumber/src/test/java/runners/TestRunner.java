package runners;
import io.cucumber.testng.*;
@CucumberOptions(features = "src/test/resources/features", glue = "steps", plugin = {"json:target/cucumber-reports/cucumber.json"})
public class TestRunner extends AbstractTestNGCucumberTests {}
